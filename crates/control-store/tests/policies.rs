use deskfleet_control_store::{
    ControlStore, Error,
    policies::{
        MachineAction, MachinePolicy, MachineScope, Policy, SiteAction, SitePolicy, TeamAction,
        TeamCreationAction, TeamCreationPolicy, TeamPolicy, TeamRole, TeamScope, authorize,
    },
};
use serde_json::json;

#[test]
fn team_policy_separates_member_operations_from_administration() {
    let member_actions = [
        TeamAction::Read,
        TeamAction::ReadMembers,
        TeamAction::ReadUsage,
        TeamAction::ReadMachines,
        TeamAction::EnrollMachine,
    ];
    let admin_actions = [
        TeamAction::Rename,
        TeamAction::Delete,
        TeamAction::ManageMembers,
    ];
    let outsider = TeamPolicy::new(None);
    let member = TeamPolicy::new(Some(TeamRole::Member));
    let admin = TeamPolicy::new(Some(TeamRole::Admin));

    for action in member_actions {
        assert!(authorize(&member, action).is_ok());
        assert!(authorize(&admin, action).is_ok());
        assert!(matches!(
            authorize(&outsider, action),
            Err(Error::Forbidden)
        ));
    }
    for action in admin_actions {
        assert!(authorize(&admin, action).is_ok());
        assert!(matches!(authorize(&member, action), Err(Error::Forbidden)));
        assert!(matches!(
            authorize(&outsider, action),
            Err(Error::Forbidden)
        ));
    }
}

#[test]
fn machine_policy_uses_target_team_membership_and_limits_removal() {
    let member = MachinePolicy::new(Some(TeamRole::Member));
    let admin = MachinePolicy::new(Some(TeamRole::Admin));
    let outsider = MachinePolicy::new(None);

    for action in [
        MachineAction::Read,
        MachineAction::Rename,
        MachineAction::Manage,
        MachineAction::Connect,
    ] {
        assert!(authorize(&member, action).is_ok());
        assert!(authorize(&admin, action).is_ok());
        assert!(matches!(
            authorize(&outsider, action),
            Err(Error::Forbidden)
        ));
    }
    assert!(authorize(&admin, MachineAction::Remove).is_ok());
    assert!(matches!(
        authorize(&member, MachineAction::Remove),
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        authorize(&outsider, MachineAction::Remove),
        Err(Error::Forbidden)
    ));
}

#[test]
fn site_authority_and_team_creation_policy_are_independent() {
    for action in [
        SiteAction::ReadSettings,
        SiteAction::UpdateSettings,
        SiteAction::ReadAudit,
    ] {
        assert!(authorize(&SitePolicy::new(true), action).is_ok());
        assert!(matches!(
            authorize(&SitePolicy::new(false), action),
            Err(Error::Forbidden)
        ));
    }
    assert!(authorize(&TeamCreationPolicy::new(true), TeamCreationAction::Create).is_ok());
    assert!(matches!(
        authorize(&TeamCreationPolicy::new(false), TeamCreationAction::Create),
        Err(Error::Forbidden)
    ));
    assert!(!TeamPolicy::new(None).permits(TeamAction::Read));
    assert!(!MachinePolicy::new(None).permits(MachineAction::Manage));
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn database_scopes_and_actions_follow_current_target_membership() {
    let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL to PostgreSQL");
    let store = ControlStore::connect(&url).await.unwrap();
    let issuer = format!("https://policy-fixture/{}", uuid::Uuid::new_v4());
    let admin = store
        .oidc_user(&issuer, "owner", "Owner", None, false)
        .await
        .unwrap();
    let member = store
        .oidc_user(
            &issuer,
            "member",
            "Member",
            Some("member@policy.test"),
            true,
        )
        .await
        .unwrap();
    let outsider = store
        .oidc_user(&issuer, "outsider", "Outsider", None, false)
        .await
        .unwrap();
    let team = store.create_team(&admin.id, "Member team").await.unwrap();
    let other_team = store.create_team(&outsider.id, "Other team").await.unwrap();
    let invite = store
        .invite(&admin.id, &team.id, "member@policy.test", "member")
        .await
        .unwrap();
    store
        .accept_invite(&member.id, invite["token"].as_str().unwrap())
        .await
        .unwrap();
    let (machine, _) = store
        .enroll(
            &admin.id,
            &team.id,
            "Member machine",
            &uuid::Uuid::new_v4().to_string(),
            "1",
            json!({}),
        )
        .await
        .unwrap();
    let (other_machine, _) = store
        .enroll(
            &outsider.id,
            &other_team.id,
            "Other machine",
            &uuid::Uuid::new_v4().to_string(),
            "1",
            json!({}),
        )
        .await
        .unwrap();
    store.grant_site_admin(&outsider.id).await.unwrap();

    let site_admin_teams = TeamScope::new(&outsider.id).resolve(&store).await.unwrap();
    assert_eq!(site_admin_teams.len(), 1);
    assert_eq!(site_admin_teams[0].id, other_team.id);
    assert!(matches!(
        MachineScope::new(&outsider.id, &team.id)
            .resolve(&store)
            .await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        store
            .authorize_machine(&outsider.id, &machine.id, MachineAction::Manage)
            .await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        store
            .change_member(&outsider.id, &team.id, &outsider.id, Some("admin"))
            .await,
        Err(Error::Forbidden)
    ));

    let teams = TeamScope::new(&member.id).resolve(&store).await.unwrap();
    assert_eq!(teams.len(), 1);
    assert_eq!(teams[0].id, team.id);
    let machines = MachineScope::new(&member.id, &team.id)
        .resolve(&store)
        .await
        .unwrap();
    assert_eq!(machines.len(), 1);
    assert_eq!(machines[0].id, machine.id);
    assert!(matches!(
        MachineScope::new(&member.id, &other_team.id)
            .resolve(&store)
            .await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        store
            .authorize_machine(&member.id, &other_machine.id, MachineAction::Manage)
            .await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        store
            .change_member(&member.id, &team.id, &member.id, Some("admin"))
            .await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        store.revoke_machine(&member.id, &machine.id).await,
        Err(Error::Forbidden)
    ));

    store
        .change_member(&admin.id, &team.id, &member.id, None)
        .await
        .unwrap();
    assert!(store.teams(&member.id).await.unwrap().is_empty());
    assert!(matches!(
        store.machines(&member.id, &team.id).await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        store
            .authorize_machine(&member.id, &machine.id, MachineAction::Connect)
            .await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        store
            .rename_machine(&member.id, &machine.id, "Denied")
            .await,
        Err(Error::Forbidden)
    ));
    assert_eq!(
        store.machine(&machine.id).await.unwrap().name,
        "Member machine"
    );
    assert!(matches!(
        store
            .change_member(&admin.id, &team.id, &admin.id, Some("member"))
            .await,
        Err(Error::Conflict(_))
    ));

    store.revoke_machine(&admin.id, &machine.id).await.unwrap();
    assert!(
        MachineScope::new(&admin.id, &team.id)
            .resolve(&store)
            .await
            .unwrap()
            .is_empty()
    );
    store.close().await.unwrap();
}
